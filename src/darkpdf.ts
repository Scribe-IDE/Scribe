// PDFs in the dark: a page is drawn as it is, then shown inverted by CSS (light text on a dark
// page, colours keeping their hue). Pictures would come out as negatives, so the places where the
// page draws an image or an included graphic (a figure's PDF) are copied back on top, uninverted,
// from the page's own canvas.
import * as pdfjs from "pdfjs-dist";
import type { PageViewport, PDFPageProxy } from "pdfjs-dist";

type Matrix = [number, number, number, number, number, number];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Rectangles (canvas pixels at `viewport`) where the page draws pictures: raster images, and
 *  included graphics at least `minSize` pt across (smaller forms are logos and glyphs). */
export async function pictureRects(page: PDFPageProxy, viewport: PageViewport, minSize = 36): Promise<[number, number, number, number][]> {
  const { fnArray, argsArray } = await page.getOperatorList();
  const OPS = pdfjs.OPS;
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  const rects: [number, number, number, number][] = [];
  const toCanvas = viewport.transform as Matrix;
  const add = (m: Matrix, x0: number, y0: number, x1: number, y1: number) => {
    const full = multiply(toCanvas, m);
    const pts = [apply(full, x0, y0), apply(full, x1, y0), apply(full, x0, y1), apply(full, x1, y1)];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  };
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = multiply(ctm, args as Matrix);
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageXObjectRepeat) {
      add(ctm, 0, 0, 1, 1); // an image fills the unit square
    } else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const [matrix, bbox] = args as [Matrix | null, [number, number, number, number] | null];
      if (matrix) ctm = multiply(ctm, matrix);
      if (bbox && Math.abs(bbox[2] - bbox[0]) >= minSize && Math.abs(bbox[3] - bbox[1]) >= minSize) add(ctm, bbox[0], bbox[1], bbox[2], bbox[3]);
    } else if (fn === OPS.paintFormXObjectEnd) {
      ctm = stack.pop() ?? ctm;
    }
  }
  // a picture inside another one is already covered
  return rects.filter((r, i) => !rects.some((o, j) => j !== i && o[0] <= r[0] && o[1] <= r[1] && o[2] >= r[2] && o[3] >= r[3] && (o[2] - o[0]) * (o[3] - o[1]) > (r[2] - r[0]) * (r[3] - r[1])));
}

/** A canvas over `canvas` with its pictures copied back as they are, to sit above the inverted page. */
export async function picturesLayer(canvas: HTMLCanvasElement, page: PDFPageProxy, viewport: PageViewport): Promise<HTMLCanvasElement | null> {
  const rects = await pictureRects(page, viewport);
  if (!rects.length) return null;
  const layer = document.createElement("canvas");
  layer.width = canvas.width;
  layer.height = canvas.height;
  layer.className = "pdf-pictures";
  const ctx = layer.getContext("2d")!;
  for (const [x0, y0, x1, y1] of rects) {
    const [x, y] = [Math.max(0, Math.floor(x0)), Math.max(0, Math.floor(y0))];
    const [w, h] = [Math.min(canvas.width, Math.ceil(x1)) - x, Math.min(canvas.height, Math.ceil(y1)) - y];
    if (w > 0 && h > 0) ctx.drawImage(canvas, x, y, w, h, x, y, w, h);
  }
  return layer;
}
