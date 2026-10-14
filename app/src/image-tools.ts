export type ImageTransform = "rotate" | "sharpen" | "background";

export interface ImageBounds { left: number; top: number; width: number; height: number; }

export function normalizedImagePoint(clientX: number, clientY: number, bounds: ImageBounds): { x: number; y: number } {
  if (bounds.width <= 0 || bounds.height <= 0) return { x: 0, y: 0 };
  return {
    x: Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width)),
    y: Math.min(1, Math.max(0, (clientY - bounds.top) / bounds.height))
  };
}

export function imageFromDataUrl(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片已损坏或格式不受支持。"));
    image.src = src;
  });
}

export async function trimWhiteMargins(src: string): Promise<string> {
  const image = await imageFromDataUrl(src);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return src;
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  let left = canvas.width;
  let top = canvas.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < canvas.height; y += 2) {
    for (let x = 0; x < canvas.width; x += 2) {
      const i = (y * canvas.width + x) * 4;
      if (pixels.data[i + 3] < 24) continue;
      const luminance = 0.2126 * pixels.data[i] + 0.7152 * pixels.data[i + 1] + 0.0722 * pixels.data[i + 2];
      if (luminance < 246) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  }
  if (right < left || bottom < top) return src;
  const paddingX = Math.max(4, Math.round((right - left + 1) * 0.035));
  const paddingY = Math.max(4, Math.round((bottom - top + 1) * 0.08));
  left = Math.max(0, left - paddingX);
  top = Math.max(0, top - paddingY);
  right = Math.min(canvas.width - 1, right + paddingX);
  bottom = Math.min(canvas.height - 1, bottom + paddingY);
  if (left === 0 && top === 0 && right === canvas.width - 1 && bottom === canvas.height - 1) return src;
  const output = document.createElement("canvas");
  output.width = right - left + 1;
  output.height = bottom - top + 1;
  output.getContext("2d")?.drawImage(canvas, left, top, output.width, output.height, 0, 0, output.width, output.height);
  return output.toDataURL("image/png");
}

export async function transformImage(src: string, kind: ImageTransform): Promise<string> {
  const image = await imageFromDataUrl(src);
  const rotate = kind === "rotate";
  const canvas = document.createElement("canvas");
  canvas.width = rotate ? image.naturalHeight : image.naturalWidth;
  canvas.height = rotate ? image.naturalWidth : image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: kind === "background" });
  if (!context) return src;
  if (rotate) {
    context.translate(canvas.width, 0);
    context.rotate(Math.PI / 2);
    context.drawImage(image, 0, 0);
    return canvas.toDataURL("image/png");
  }
  context.filter = kind === "sharpen" ? "contrast(1.22) brightness(1.02)" : "none";
  context.drawImage(image, 0, 0);
  context.filter = "none";
  if (kind === "background") {
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const luminance = 0.2126 * pixels.data[i] + 0.7152 * pixels.data[i + 1] + 0.0722 * pixels.data[i + 2];
      const value = luminance < 214 ? 0 : 255;
      pixels.data[i] = value;
      pixels.data[i + 1] = value;
      pixels.data[i + 2] = value;
      pixels.data[i + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
  }
  return canvas.toDataURL("image/png");
}
