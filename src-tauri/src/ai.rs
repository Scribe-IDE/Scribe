//! The AI assistant's connection to the user's own model: Anthropic's Messages API, or any
//! OpenAI-compatible chat API (OpenAI, Google Gemini, OpenRouter, Groq, LM Studio, and Ollama on
//! this machine). Requests go from here, not the web view, so API keys stay in the system's
//! keychain and never reach the page. Replies stream back to the page through a Channel.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Mutex, Once};
use std::time::Duration;
use tauri::ipc::Channel;

/// The keychain service the keys are stored under, one entry per provider kind.
const SERVICE: &str = "com.georgekiritsis.scribe.ai";

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    /// "anthropic", "openai", "gemini", "ollama" or "compatible".
    kind: String,
    /// Required for "compatible"; optional for "ollama" (default: this machine).
    base_url: Option<String>,
    model: String,
}

#[derive(Deserialize)]
pub struct Message {
    role: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    /// Chosen by the page, so it can cancel this request.
    id: u64,
    provider: Provider,
    system: String,
    messages: Vec<Message>,
    max_tokens: Option<u32>,
    /// "low" for quick suggestions; Anthropic models take it as effort.
    speed: Option<String>,
    stop: Option<Vec<String>>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    Delta { text: String },
    Done { reason: Option<String> },
    Error { message: String },
}

fn entry(kind: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, kind).map_err(|e| e.to_string())
}

fn key(kind: &str) -> Option<String> {
    entry(kind).ok()?.get_password().ok().filter(|k| !k.is_empty())
}

/// Keep a provider's API key in the system keychain; an empty key removes it.
#[tauri::command]
pub fn ai_set_key(kind: String, key: String) -> Result<(), String> {
    let e = entry(&kind)?;
    if key.trim().is_empty() {
        return match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        };
    }
    e.set_password(key.trim()).map_err(|e| format!("Couldn't keep the key in the keychain: {e}"))
}

/// Whether a key is kept for this provider (the key itself never leaves the back end).
#[tauri::command]
pub fn ai_has_key(kind: String) -> bool {
    key(&kind).is_some()
}

static CANCELLED: Mutex<Option<HashSet<u64>>> = Mutex::new(None);

#[tauri::command]
pub fn ai_cancel(id: u64) {
    CANCELLED.lock().unwrap().get_or_insert_with(HashSet::new).insert(id);
}

fn cancelled(id: u64) -> bool {
    CANCELLED.lock().unwrap().as_mut().is_some_and(|set| set.remove(&id))
}

fn client() -> Result<reqwest::Client, String> {
    static TLS: Once = Once::new();
    TLS.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

fn base_url(p: &Provider) -> Result<String, String> {
    let given = p.base_url.as_deref().map(|u| u.trim().trim_end_matches('/').to_string()).filter(|u| !u.is_empty());
    Ok(match p.kind.as_str() {
        // an address of its own: a proxy, or a test server
        "anthropic" => given.unwrap_or_else(|| "https://api.anthropic.com/v1".into()),
        "openai" => "https://api.openai.com/v1".into(),
        "gemini" => "https://generativelanguage.googleapis.com/v1beta/openai".into(),
        "ollama" => given.unwrap_or_else(|| "http://localhost:11434/v1".into()),
        "compatible" => given.ok_or("Set the address of the API (its base URL) in Settings > AI.")?,
        other => return Err(format!("unknown provider {other}")),
    })
}

/// The provider's error message from a failed response, or its status.
async fn failure(resp: reqwest::Response) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let message = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().or(v["error"].as_str()).or(v["message"].as_str()).map(String::from))
        .unwrap_or_else(|| body.chars().take(300).collect());
    match status.as_u16() {
        401 | 403 => format!("The provider refused the key ({status}): {message}"),
        404 => format!("Not found ({status}): {message}. Check the model name."),
        429 => format!("Rate limited ({status}): {message}"),
        _ => format!("{status}: {message}"),
    }
}

/// Send one request and stream its text to the page. Ends with Done or Error.
#[tauri::command]
pub async fn ai_stream(request: Request, on_event: Channel<Event>) -> Result<(), String> {
    let id = request.id;
    let send = |event: Event| {
        let _ = on_event.send(event);
    };
    match run(request, &send).await {
        Ok(reason) => {
            let _ = on_event.send(Event::Done { reason });
        }
        Err(message) => {
            let _ = on_event.send(Event::Error { message });
        }
    }
    cancelled(id); // forget a cancel that arrived after the end
    Ok(())
}

async fn run(req: Request, send: &(dyn Fn(Event) + Send + Sync)) -> Result<Option<String>, String> {
    let p = &req.provider;
    let base = base_url(p)?;
    let api_key = key(&p.kind);
    let own_address = p.base_url.as_deref().is_some_and(|u| !u.trim().is_empty());
    if api_key.is_none() && !own_address && p.kind != "ollama" && p.kind != "compatible" {
        return Err("No API key yet. Add one in Settings > AI.".into());
    }
    let anthropic = p.kind == "anthropic";
    let max_tokens = req.max_tokens.unwrap_or(16000);
    let http = client()?;
    let builder = if anthropic {
        let mut body = json!({
            "model": p.model,
            "max_tokens": max_tokens,
            "system": req.system,
            "messages": req.messages.iter().map(|m| json!({ "role": m.role, "content": m.content })).collect::<Vec<_>>(),
            "stream": true,
            // a policy decline is retried on another model inside the same call
            "fallbacks": "default",
        });
        if let Some(stop) = &req.stop {
            body["stop_sequences"] = json!(stop);
        }
        if let Some(speed) = &req.speed {
            body["output_config"] = json!({ "effort": speed });
        }
        http.post(format!("{base}/messages"))
            .header("x-api-key", api_key.unwrap_or_default())
            .header("anthropic-version", "2023-06-01")
            .header("anthropic-beta", "server-side-fallback-2026-07-01")
            .json(&body)
    } else {
        let mut messages = vec![json!({ "role": "system", "content": req.system })];
        messages.extend(req.messages.iter().map(|m| json!({ "role": m.role, "content": m.content })));
        let mut body = json!({ "model": p.model, "messages": messages, "stream": true });
        // OpenAI's own API wants the newer name; the others still read max_tokens
        body[if p.kind == "openai" { "max_completion_tokens" } else { "max_tokens" }] = json!(max_tokens);
        if let Some(stop) = &req.stop {
            body["stop"] = json!(stop);
        }
        let b = http.post(format!("{base}/chat/completions")).json(&body);
        match api_key {
            Some(k) => b.bearer_auth(k),
            None => b,
        }
    };
    let resp = builder.send().await.map_err(|e| {
        if p.kind == "ollama" && e.is_connect() {
            "Ollama isn't running on this computer. Start it (ollama serve) or choose another provider.".to_string()
        } else {
            format!("Couldn't reach the provider: {e}")
        }
    })?;
    if !resp.status().is_success() {
        return Err(failure(resp).await);
    }

    // Server-sent events: "data: {...}" lines, one event per blank-line-separated block.
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut reason: Option<String> = None;
    while let Some(chunk) = stream.next().await {
        if cancelled(req.id) {
            return Ok(Some("cancelled".into()));
        }
        buffer.push_str(&String::from_utf8_lossy(&chunk.map_err(|e| e.to_string())?));
        while let Some(end) = buffer.find('\n') {
            let line = buffer[..end].trim_end_matches('\r').to_string();
            buffer.drain(..=end);
            let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
            if data == "[DONE]" {
                return Ok(reason);
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
            if anthropic {
                match v["type"].as_str() {
                    Some("content_block_delta") if v["delta"]["type"] == "text_delta" => {
                        send(Event::Delta { text: v["delta"]["text"].as_str().unwrap_or_default().into() });
                    }
                    Some("message_delta") => {
                        if let Some(r) = v["delta"]["stop_reason"].as_str() {
                            reason = Some(r.into());
                        }
                    }
                    Some("error") => return Err(v["error"]["message"].as_str().unwrap_or("The provider stopped with an error.").into()),
                    Some("message_stop") => return Ok(reason),
                    _ => {}
                }
            } else {
                if let Some(err) = v["error"]["message"].as_str() {
                    return Err(err.into());
                }
                let choice = &v["choices"][0];
                if let Some(text) = choice["delta"]["content"].as_str() {
                    if !text.is_empty() {
                        send(Event::Delta { text: text.into() });
                    }
                }
                if let Some(r) = choice["finish_reason"].as_str() {
                    reason = Some(r.into());
                }
            }
        }
    }
    Ok(reason)
}

/// The models a provider offers, for the model picker in Settings.
#[tauri::command]
pub async fn ai_models(provider: Provider) -> Result<Vec<String>, String> {
    let base = base_url(&provider)?;
    let http = client()?;
    let mut req = http.get(format!("{base}/models")).timeout(Duration::from_secs(20));
    if let Some(k) = key(&provider.kind) {
        req = if provider.kind == "anthropic" {
            req.header("x-api-key", k).header("anthropic-version", "2023-06-01")
        } else {
            req.bearer_auth(k)
        };
    }
    let resp = req.send().await.map_err(|e| format!("Couldn't reach the provider: {e}"))?;
    if !resp.status().is_success() {
        return Err(failure(resp).await);
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut ids: Vec<String> = v["data"]
        .as_array()
        .map(|list| list.iter().filter_map(|m| m["id"].as_str().map(|s| s.trim_start_matches("models/").to_string())).collect())
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;

    /// A one-request HTTP server answering with `status` and `body`; returns its address and the
    /// request it received (headers and body).
    fn serve(status: &str, content_type: &str, body: &str) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = format!("http://{}/v1", listener.local_addr().unwrap());
        let (status, content_type, body) = (status.to_string(), content_type.to_string(), body.to_string());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 8192];
            // headers, then as much body as Content-Length says
            loop {
                let n = stream.read(&mut buf).unwrap();
                request.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&request).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let reply = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nConnection: close\r\n\r\n{body}");
            stream.write_all(reply.as_bytes()).unwrap();
            String::from_utf8_lossy(&request).to_string()
        });
        (addr, handle)
    }

    fn request(kind: &str, base_url: &str, speed: Option<&str>) -> Request {
        Request {
            id: 1,
            provider: Provider { kind: kind.into(), base_url: Some(base_url.into()), model: "test-model".into() },
            system: "Be brief.".into(),
            messages: vec![Message { role: "user".into(), content: "Hello?".into() }],
            max_tokens: Some(100),
            speed: speed.map(String::from),
            stop: Some(vec!["\n\n".into()]),
        }
    }

    /// Runs a request and gathers what it streamed.
    fn collect(req: Request) -> (Result<Option<String>, String>, String) {
        let text = Arc::new(Mutex::new(String::new()));
        let sink = text.clone();
        let send = move |e: Event| {
            if let Event::Delta { text } = e {
                sink.lock().unwrap().push_str(&text);
            }
        };
        let result = tauri::async_runtime::block_on(run(req, &send));
        let out = text.lock().unwrap().clone();
        (result, out)
    }

    #[test]
    fn streams_an_openai_compatible_reply() {
        let sse = "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n\
                   data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n\
                   data: {\"choices\":[{\"delta\":{\"content\":\"lo\"},\"finish_reason\":\"stop\"}]}\n\n\
                   data: [DONE]\n\n";
        let (addr, server) = serve("200 OK", "text/event-stream", sse);
        let (result, text) = collect(request("compatible", &addr, None));
        assert_eq!(result.unwrap().as_deref(), Some("stop"));
        assert_eq!(text, "Hello");
        let sent = server.join().unwrap();
        assert!(sent.starts_with("POST /v1/chat/completions"), "{sent}");
        let body: Value = serde_json::from_str(&sent[sent.find("\r\n\r\n").unwrap() + 4..]).unwrap();
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["content"], "Hello?");
        assert_eq!(body["max_tokens"], 100);
        assert_eq!(body["stream"], true);
    }

    #[test]
    fn streams_an_anthropic_reply_without_its_thinking() {
        let sse = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{}}\n\n\
                   event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n\
                   event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"hmm\"}}\n\n\
                   event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi \"}}\n\n\
                   event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"there\"}}\n\n\
                   event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n\
                   event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
        let (addr, server) = serve("200 OK", "text/event-stream", sse);
        let (result, text) = collect(request("anthropic", &addr, Some("low")));
        assert_eq!(result.unwrap().as_deref(), Some("end_turn"));
        assert_eq!(text, "Hi there");
        let sent = server.join().unwrap();
        assert!(sent.starts_with("POST /v1/messages"), "{sent}");
        assert!(sent.to_ascii_lowercase().contains("anthropic-version: 2023-06-01"));
        let body: Value = serde_json::from_str(&sent[sent.find("\r\n\r\n").unwrap() + 4..]).unwrap();
        assert_eq!(body["system"], "Be brief.");
        assert_eq!(body["output_config"]["effort"], "low");
        assert_eq!(body["stop_sequences"][0], "\n\n");
        assert_eq!(body["fallbacks"], "default");
        assert!(body.get("temperature").is_none(), "current models reject sampling settings");
    }

    #[test]
    fn says_why_a_request_was_refused() {
        let (addr, _server) = serve("401 Unauthorized", "application/json", "{\"error\":{\"message\":\"invalid x-api-key\"}}");
        let (result, _) = collect(request("anthropic", &addr, None));
        let err = result.unwrap_err();
        assert!(err.contains("refused the key") && err.contains("invalid x-api-key"), "{err}");
    }

    #[test]
    fn reports_a_declined_request() {
        let sse = "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"refusal\"}}\n\n\
                   event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
        let (addr, _server) = serve("200 OK", "text/event-stream", sse);
        let (result, _) = collect(request("anthropic", &addr, None));
        assert_eq!(result.unwrap().as_deref(), Some("refusal"));
    }
}
