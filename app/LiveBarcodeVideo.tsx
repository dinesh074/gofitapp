// Native stub for the web-only live webcam scanner (LiveBarcodeVideo.web.tsx).
// On native the live barcode scanner is expo-camera's CameraView, so this
// renders nothing. It exists only so the shared import in BarcodeScanner
// resolves and type-checks on native as well as web.
type Props = {
  onDetected: (code: string) => void;
  onError: (message: string) => void;
};

export default function LiveBarcodeVideo(_props: Props): null {
  return null;
}
