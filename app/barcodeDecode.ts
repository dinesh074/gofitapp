// Decode a barcode from a still image. This is the path that makes barcode
// scanning actually work on the WEB build (gofit.today), where Expo's live
// CameraView barcode decoding isn't reliable. The user picks/takes a photo of
// the barcode and we decode it locally in the browser with ZXing — no server
// round-trip, no AI credit. On native the live CameraView scanner is still the
// primary path; this is an extra fallback.
import { Platform } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { BrowserMultiFormatReader, DecodeHintType, BarcodeFormat } from "@zxing/library";

// Only the browser build has the DOM (Image/canvas) that ZXing needs to decode
// a still image. On native we rely on the live camera scanner instead.
export const canPhotoScan = Platform.OS === "web";

export class BarcodeDecodeError extends Error {}

// Restrict to the 1D product formats found on packaged food, so ZXing doesn't
// waste time on QR/PDF417 and is less likely to mis-read.
function makeReader(): BrowserMultiFormatReader {
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.EAN_13,
    BarcodeFormat.EAN_8,
    BarcodeFormat.UPC_A,
    BarcodeFormat.UPC_E,
    BarcodeFormat.CODE_128,
  ]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  return new BrowserMultiFormatReader(hints);
}

// Let the user pick an existing photo of a barcode (or take one). Returns the
// image URI, or null if they cancelled.
export async function pickBarcodeImage(): Promise<string | null> {
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    quality: 1,
    allowsEditing: false,
  });
  if (res.canceled || !res.assets?.length) return null;
  return res.assets[0].uri;
}

// Decode a barcode from the given image URI. Resolves to the digits, or throws
// BarcodeDecodeError if nothing readable was found.
export async function decodeBarcodeFromUri(uri: string): Promise<string> {
  if (!canPhotoScan) {
    throw new BarcodeDecodeError("Photo barcode scanning is only available on the web app.");
  }
  const reader = makeReader();
  try {
    const result = await reader.decodeFromImageUrl(uri);
    const text = (result?.getText() || "").replace(/\D/g, "");
    if (text.length < 8) {
      throw new BarcodeDecodeError("Couldn't read a barcode in that photo.");
    }
    return text;
  } catch (e: any) {
    if (e instanceof BarcodeDecodeError) throw e;
    throw new BarcodeDecodeError(
      "Couldn't read a barcode in that photo. Try a clearer, straight-on shot."
    );
  } finally {
    try {
      reader.reset();
    } catch {
      /* noop */
    }
  }
}
