# %% [markdown]
# # Optimiser comparison on two moons
#
# Everything the paper reports comes from this notebook. Figure cells become
# `figures/<id>.pdf`; `nbval()`, `nbmath()` and `nbtable()` send numbers, formulas and the
# results table to the text.
#
# Each optimiser minimises the cross-entropy loss $\mathcal{L}(\theta)$ of the same network.
# Plain SGD steps along the mini-batch gradient $g_t$:
#
# $$\theta_{t+1} = \theta_t - \eta\, g_t$$
#
# Momentum and Adam change **how** that gradient is used, not what is being minimised.

# %%
import numpy as np
import matplotlib.pyplot as plt

SEEDS = [0, 1, 2, 3, 4]     # one training run per seed, so results come with a spread
DATA_SEED = 0
N_TRAIN, N_TEST = 400, 400
EPOCHS = 100
BATCH = 32
HIDDEN = 16

def two_moons(n, noise, rng):
    """Two interleaving half circles, the classic non-linear toy problem."""
    t = rng.uniform(0, np.pi, n)
    upper = rng.integers(0, 2, n).astype(bool)
    x = np.where(upper, np.cos(t), 1 - np.cos(t))
    y = np.where(upper, np.sin(t), 0.5 - np.sin(t))
    points = np.stack([x, y], axis=1) + rng.normal(0, noise, (n, 2))
    return points, (~upper).astype(float)

rng = np.random.default_rng(DATA_SEED)
X_train, y_train = two_moons(N_TRAIN, 0.2, rng)
X_test, y_test = two_moons(N_TEST, 0.2, rng)

# %%
def init_params(rng):
    return {
        "W1": rng.normal(0, 0.5, (2, HIDDEN)), "b1": np.zeros(HIDDEN),
        "W2": rng.normal(0, 0.5, (HIDDEN, 1)), "b2": np.zeros(1),
    }

def forward(p, X):
    h = np.tanh(X @ p["W1"] + p["b1"])
    return h, 1 / (1 + np.exp(-(h @ p["W2"] + p["b2"]).ravel()))

def loss_and_grads(p, X, y):
    h, prob = forward(p, X)
    loss = -np.mean(y * np.log(prob + 1e-9) + (1 - y) * np.log(1 - prob + 1e-9))
    d_out = (prob - y)[:, None] / len(y)
    d_h = (d_out @ p["W2"].T) * (1 - h ** 2)
    return loss, {"W1": X.T @ d_h, "b1": d_h.sum(0), "W2": h.T @ d_out, "b2": d_out.sum(0)}

def accuracy(p, X, y):
    return np.mean((forward(p, X)[1] > 0.5) == y)

def train(optimiser, lr, seed):
    """One run. For a given seed every optimiser starts from the same weights and sees the
    same batches, so differences between them are down to the update rule alone."""
    rng = np.random.default_rng(seed)
    p = init_params(rng)
    m = {k: np.zeros_like(v) for k, v in p.items()}   # momentum / first moment
    v = {k: np.zeros_like(v) for k, v in p.items()}   # second moment (Adam)
    history, step = [], 0
    for _ in range(EPOCHS):
        order = rng.permutation(N_TRAIN)
        for start in range(0, N_TRAIN, BATCH):
            batch = order[start:start + BATCH]
            _, g = loss_and_grads(p, X_train[batch], y_train[batch])
            step += 1
            for k in p:
                if optimiser == "SGD":
                    p[k] -= lr * g[k]
                elif optimiser == "Momentum":
                    m[k] = 0.9 * m[k] + g[k]
                    p[k] -= lr * m[k]
                else:  # Adam
                    m[k] = 0.9 * m[k] + 0.1 * g[k]
                    v[k] = 0.999 * v[k] + 0.001 * g[k] ** 2
                    m_hat, v_hat = m[k] / (1 - 0.9 ** step), v[k] / (1 - 0.999 ** step)
                    p[k] -= lr * m_hat / (np.sqrt(v_hat) + 1e-8)
        history.append(loss_and_grads(p, X_train, y_train)[0])
    return p, np.array(history)

# %%
SETTINGS = {"SGD": 0.1, "Momentum": 0.1, "Adam": 0.01}
runs = {name: [train(name, lr, seed) for seed in SEEDS] for name, lr in SETTINGS.items()}

def epochs_to(history, target=0.1):
    """First epoch at which the training loss drops below the target, or None."""
    below = np.nonzero(history < target)[0]
    return int(below[0]) + 1 if len(below) else None

# Per optimiser: test accuracy, final loss and time-to-target over the seeds.
acc = {name: np.array([100 * accuracy(p, X_test, y_test) for p, _ in rs]) for name, rs in runs.items()}
loss = {name: np.array([h[-1] for _, h in rs]) for name, rs in runs.items()}
speed = {name: [epochs_to(h) for _, h in rs] for name, rs in runs.items()}

rows = []
for name in runs:
    reached = [e for e in speed[name] if e is not None]
    rows.append([
        name,
        SETTINGS[name],
        (loss[name].mean(), loss[name].std()),
        (acc[name].mean(), acc[name].std()),
        (np.mean(reached), np.std(reached)) if len(reached) == len(SEEDS) else "--",
    ])
    nbval(f"acc-{name.lower()}", acc[name].mean(), err=acc[name].std(), unit="\\percent")
nbtable("results", rows, header=["Optimiser", "Learning rate", "Final loss", "Test acc. (%)", "Epochs to 0.1"])

best = max(acc, key=lambda name: acc[name].mean())
nbval("best", best)
nbval("best-acc", acc[best].mean(), err=acc[best].std(), unit="\\percent")
nbval("acc-spread", f"{max(a.mean() for a in acc.values()) - min(a.mean() for a in acc.values()):.1f}")

# The optimiser that gets the training loss under 0.1 first, among those that always get there.
always = {name: e for name, e in speed.items() if all(x is not None for x in e)}
fastest = min(always, key=lambda name: np.mean(always[name]))
nbval("fastest", fastest)
nbval("fastest-epochs", np.mean(always[fastest]), err=np.std(always[fastest]))

nbval("n-train", N_TRAIN)
nbval("n-test", N_TEST)
nbval("n-seeds", len(SEEDS))
nbval("epochs", EPOCHS)
nbval("hidden", HIDDEN)
nbval("batch", BATCH)
nbmath("n-params", f"2h + h + h + 1 = {4 * HIDDEN + 1}")

# %%
# Keep the curves as data too: data/curves.csv opens in Scribe as a table and a quick plot.
import os
os.makedirs("data", exist_ok=True)
mean_loss = {name: np.array([h for _, h in rs]).mean(0) for name, rs in runs.items()}
np.savetxt(
    "data/curves.csv",
    np.column_stack([np.arange(1, EPOCHS + 1)] + [mean_loss[name] for name in runs]),
    delimiter=",", header="epoch," + ",".join(name.lower() for name in runs), comments="", fmt="%.5g",
)

# %% [figure: fig-curves]
COLOURS = {"SGD": "#8a8885", "Momentum": "#458588", "Adam": "#d4a556"}
fig, ax = plt.subplots(figsize=(5.2, 3))
epochs = np.arange(1, EPOCHS + 1)
for name, rs in runs.items():
    histories = np.array([h for _, h in rs])
    mean, std = histories.mean(0), histories.std(0)
    ax.fill_between(epochs, mean - std, mean + std, color=COLOURS[name], alpha=0.2, linewidth=0)
    ax.plot(epochs, mean, color=COLOURS[name], linewidth=1.6, label=name)
ax.axhline(0.1, color="#bbbbbb", linewidth=0.8, linestyle=":")
ax.set_yscale("log")
ax.set_xlabel("Epoch")
ax.set_ylabel("Training loss")
ax.legend(frameon=False)
ax.spines[["top", "right"]].set_visible(False)
fig.tight_layout()

# %% [figure: fig-boundary]
params = runs[best][0][0]   # the first seed's run of the best optimiser
gx, gy = np.meshgrid(np.linspace(-1.6, 2.6, 220), np.linspace(-1.2, 1.7, 220))
prob = forward(params, np.stack([gx.ravel(), gy.ravel()], axis=1))[1].reshape(gx.shape)

fig, ax = plt.subplots(figsize=(5.2, 3.2))
ax.contourf(gx, gy, prob, levels=[0, 0.5, 1], colors=["#f3e3c3", "#d9dee0"])
ax.contour(gx, gy, prob, levels=[0.5], colors="#3c3836", linewidths=1)
ax.scatter(*X_test[y_test == 0].T, s=9, color="#b0791f", label="Class 0")
ax.scatter(*X_test[y_test == 1].T, s=9, color="#458588", label="Class 1")
ax.set_xticks([])
ax.set_yticks([])
ax.legend(frameon=False, loc="upper right")
fig.tight_layout()
