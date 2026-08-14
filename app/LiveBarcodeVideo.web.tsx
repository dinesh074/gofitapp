// Live webcam barcode scanning for the WEB build (gofit.today). Expo's
// CameraView barcode decoding isn't reliable in the browser, so on web we open
// the webcam ourselves and run ZXing's continuous decoder over the video feed.
// This is what makes the web app a real "point your camera" scanner rather than
// only a pick-a-photo fallback. Native uses expo-camera's live scanner instead
// (see LiveBarcodeVideo.tsx, a no-op stub so this file never loads on native).
import React, { useEffect, useRef } from "react";
import { BrowserMultiFormatReader, DecodeHintType, BarcodeFormat } from "@zxing/library";

type Props = {
  // Fired once with the barcode digits as soon as a valid code is read.
  onDetected: (code: string) => void;
  // Fired if the camera can't be opened (permission denied, no camera, etc.)
  // so the caller can fall back to the photo / manual paths.
  onError: (message: string) => void;
};

function makeReader(): BrowserMultiFormatReader {
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.EAN_13,
    BarcodeFormat.EAN_8,
    BarcodeFormat.UPC_A,
    BarcodeFormat.UPC_E,
  ]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  return new BrowserMultiFormatReader(hints);
}

export default function LiveBarcodeVideo({ onDetected, onError }: Props) {
  const videoRef = useRef<any>(null);
  // ZXing calls the decode callback many times per second; only report the
  // first valid read so the parent doesn't fire a lookup repeatedly.
  const firedRef = useRef(false);

  useEffect(() => {
    const reader = makeReader();
    let cancelled = false;
    (async () => {
      try {
        await reader.decodeFromConstraints(
          { video: { facingMode: "environment" } },
          videoRef.current,
          (result) => {
            if (cancelled || firedRef.current || !result) return;
            const digits = (result.getText() || "").replace(/\D/g, "");
            if (digits.length >= 8) {
              firedRef.current = true;
              onDetected(digits);
            }
          }
        );
      } catch (e: any) {
        if (!cancelled) {
          onError(
            e?.message ||
              "Couldn't start the camera. Allow camera access, or scan from a photo."
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      try {
        reader.reset();
      } catch {
        /* noop */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A real <video> element (react-native-web renders through react-dom on web,
  // so a raw DOM tag works here). Cast to any to avoid needing DOM lib types.
  return React.createElement("video" as any, {
    ref: videoRef,
    autoPlay: true,
    muted: true,
    playsInline: true,
    style: { width: "100%", height: "100%", objectFit: "cover" },
  });
}
