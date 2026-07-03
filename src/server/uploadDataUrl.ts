import { HttpError } from "./http";
import { requiredString } from "./validate";

const maxSourceImageBytes = 16 * 1024 * 1024;
const maxMaskImageBytes = 8 * 1024 * 1024;

export function decodeImageDataUrl(rawValue: unknown): { mimeType: string; bytes: Buffer } {
  const dataUrl = requiredString(rawValue, "dataUrl");
  if (dataUrl.length > Math.ceil(maxSourceImageBytes * 1.4) + 128) {
    throw new HttpError(413, `Source image is too large. The maximum upload size is ${formatBytes(maxSourceImageBytes)}.`);
  }

  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) {
    throw new HttpError(400, "dataUrl must be a base64 data URL for image/png, image/jpeg, or image/webp.");
  }

  const mimeType = match[1]!.toLowerCase();
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.length === 0) {
    throw new HttpError(400, "Source image is empty.");
  }
  if (bytes.length > maxSourceImageBytes) {
    throw new HttpError(413, `Source image is too large. The maximum upload size is ${formatBytes(maxSourceImageBytes)}.`);
  }
  if (!bytesMatchMimeType(bytes, mimeType)) {
    throw new HttpError(400, "dataUrl content does not match the declared image MIME type.");
  }

  return { mimeType, bytes };
}

export function decodeMaskDataUrl(rawValue: unknown): { bytes: Buffer } {
  const dataUrl = requiredString(rawValue, "inpaint.maskDataUrl");
  if (dataUrl.length > Math.ceil(maxMaskImageBytes * 1.4) + 128) {
    throw new HttpError(413, `Mask image is too large. The maximum upload size is ${formatBytes(maxMaskImageBytes)}.`);
  }

  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) {
    throw new HttpError(400, "inpaint.maskDataUrl must be a base64 PNG data URL.");
  }

  const bytes = Buffer.from(match[1]!, "base64");
  if (bytes.length === 0) {
    throw new HttpError(400, "Mask image is empty.");
  }
  if (bytes.length > maxMaskImageBytes) {
    throw new HttpError(413, `Mask image is too large. The maximum upload size is ${formatBytes(maxMaskImageBytes)}.`);
  }
  if (!bytesMatchMimeType(bytes, "image/png")) {
    throw new HttpError(400, "Mask data URL content is not a PNG image.");
  }

  return { bytes };
}

export function decodeControlImageDataUrl(rawValue: unknown): { bytes: Buffer } {
  const dataUrl = requiredString(rawValue, "controlnet.poseImageDataUrl");
  if (dataUrl.length > Math.ceil(maxMaskImageBytes * 1.4) + 128) {
    throw new HttpError(413, `Control image is too large. The maximum upload size is ${formatBytes(maxMaskImageBytes)}.`);
  }

  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) {
    throw new HttpError(400, "controlnet.poseImageDataUrl must be a base64 PNG data URL.");
  }

  const bytes = Buffer.from(match[1]!, "base64");
  if (bytes.length === 0) {
    throw new HttpError(400, "Control image is empty.");
  }
  if (bytes.length > maxMaskImageBytes) {
    throw new HttpError(413, `Control image is too large. The maximum upload size is ${formatBytes(maxMaskImageBytes)}.`);
  }
  if (!bytesMatchMimeType(bytes, "image/png")) {
    throw new HttpError(400, "Control image data URL content is not a PNG image.");
  }

  return { bytes };
}

export function normalizedUploadFileName(filename: string, mimeType: string) {
  const trimmed = filename.trim() || "source";
  if (/\.(png|jpe?g|webp)$/i.test(trimmed)) {
    return trimmed;
  }
  const ext = mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/webp" ? ".webp" : ".png";
  return `${trimmed}${ext}`;
}

function bytesMatchMimeType(bytes: Buffer, mimeType: string) {
  if (mimeType === "image/png") {
    return bytes.length >= 8 && bytes.toString("ascii", 1, 4) === "PNG";
  }
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/webp") {
    return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  }
  return false;
}

function formatBytes(bytes: number) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}
