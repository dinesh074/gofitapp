import { Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import {
  createProOrder,
  verifyProPayment,
  getPayConfig,
  getMe,
  checkoutUrl,
  ProOrder,
  RazorpayResult,
} from "./api";
import { Account } from "./auth";

// Thrown when the user closes/cancels the Razorpay sheet — the caller should
// treat this as a no-op (no error toast).
export class PaymentCancelledError extends Error {
  constructor() {
    super("Payment cancelled");
    this.name = "PaymentCancelledError";
  }
}

// True when the backend has Razorpay keys configured (real payments available).
export async function isPaymentsConfigured(): Promise<boolean> {
  try {
    return (await getPayConfig()).configured;
  } catch {
    return false;
  }
}

// Runs the full Razorpay purchase flow for the signed-in account and resolves
// with the upgraded (Pro) account. Web uses Razorpay checkout.js in-page; native
// opens the backend-hosted checkout page in an in-app browser.
export async function purchasePro(): Promise<Account> {
  const order = await createProOrder();
  return Platform.OS === "web" ? purchaseWeb(order) : purchaseNative(order);
}

/* ------------------------------ web flow --------------------------------- */

function loadRazorpayScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const w = window as any;
    if (w.Razorpay) return resolve();
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Couldn't load the payment SDK."));
    document.body.appendChild(s);
  });
}

async function purchaseWeb(order: ProOrder): Promise<Account> {
  await loadRazorpayScript();
  const Razorpay = (window as any).Razorpay;
  return new Promise<Account>((resolve, reject) => {
    const rzp = new Razorpay({
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amount,
      currency: order.currency,
      name: order.name,
      description: "Pro subscription",
      prefill: { name: order.prefill.name, email: order.prefill.email },
      theme: { color: "#0B7A4B" },
      handler: async (resp: RazorpayResult) => {
        try {
          const res = await verifyProPayment(resp);
          resolve(res.account);
        } catch (e) {
          reject(e instanceof Error ? e : new Error("Payment verification failed."));
        }
      },
      modal: { ondismiss: () => reject(new PaymentCancelledError()) },
    });
    rzp.on("payment.failed", () =>
      reject(new Error("Payment failed. Please try again."))
    );
    rzp.open();
  });
}

/* ----------------------------- native flow ------------------------------- */

async function purchaseNative(order: ProOrder): Promise<Account> {
  const redirect = Linking.createURL("pro-return");
  const url = checkoutUrl(order, redirect);
  const result = await WebBrowser.openAuthSessionAsync(url, redirect);

  if (result.type !== "success" || !result.url) {
    throw new PaymentCancelledError();
  }
  const status = new URL(result.url).searchParams.get("status");
  if (status === "cancelled") throw new PaymentCancelledError();
  if (status !== "success") throw new Error("Payment failed. Please try again.");

  // The hosted page already verified & upgraded server-side; fetch the fresh
  // Pro account.
  const me = await getMe();
  return me.account;
}
