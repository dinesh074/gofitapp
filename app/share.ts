import { Platform } from "react-native";
import * as Sharing from "expo-sharing";

// One place that knows how to "share an image" correctly on every platform, so
// screens don't each reinvent it (and get it wrong on web). The old code called
// window.open / a download-anchor on web, which never showed the OS share sheet
// -- so users couldn't post straight to Instagram/TikTok/WhatsApp. This routes
// to the real share sheet everywhere it exists and only falls back to a file
// download when the browser genuinely can't share.

export type ShareOutcome = "shared" | "downloaded" | "unavailable";

type ShareOpts = {
  filename?: string;
  // Short caption offered to the target app (Instagram/WhatsApp caption, etc).
  message?: string;
  dialogTitle?: string;
};

export async function shareImage(uri: string, opts: ShareOpts = {}): Promise<ShareOutcome> {
  const filename = opts.filename || "gofit-today.png";
  if (Platform.OS === "web") {
    return shareImageWeb(uri, filename, opts.message);
  }
  // Native: expo-sharing opens the system share sheet (AirDrop, Instagram
  // Stories, WhatsApp, Save to Files/Photos, ...).
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType: "image/png",
      dialogTitle: opts.dialogTitle || "Share your day",
      UTI: "public.png",
    });
    return "shared";
  }
  return "unavailable";
}

async function shareImageWeb(
  uri: string,
  filename: string,
  message?: string
): Promise<ShareOutcome> {
  try {
    const nav: any = typeof navigator !== "undefined" ? navigator : undefined;
    if (nav?.share && nav?.canShare) {
      // Convert the captured image (data-uri or blob-uri) into a real File so
      // the Web Share API can attach it -- this is what makes the OS share
      // sheet (with Instagram/TikTok/WhatsApp targets) appear on mobile web.
      const blob = await (await fetch(uri)).blob();
      const file = new File([blob], filename, { type: blob.type || "image/png" });
      if (nav.canShare({ files: [file] })) {
        await nav.share({
          files: [file],
          title: "gofit.today",
          text: message,
        });
        return "shared";
      }
    }
  } catch (e: any) {
    // The user dismissing the share sheet rejects with AbortError -- that's a
    // successful "they saw the options and chose to close it", not a failure.
    if (e?.name === "AbortError") return "shared";
    // Any other error: fall through to a download so the user still gets the image.
  }
  downloadWeb(uri, filename);
  return "downloaded";
}

// Explicit "save to device" -- a download on web; on native the share sheet
// already exposes Save to Photos/Files, so this just opens it.
export async function saveImage(uri: string, filename = "gofit-today.png"): Promise<ShareOutcome> {
  if (Platform.OS === "web") {
    downloadWeb(uri, filename);
    return "downloaded";
  }
  return shareImage(uri, { filename, dialogTitle: "Save image" });
}

function downloadWeb(uri: string, filename: string): void {
  const a = document.createElement("a");
  a.href = uri;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
