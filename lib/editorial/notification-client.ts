"use client";

export interface EditorialNotificationCapability {
  secureContext: boolean;
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  subscription: "unsupported" | "no-service-worker" | "unsubscribed" | "subscribed" | "unknown";
}

/** Observation only: never requests permission, registers a worker or subscribes. */
export async function inspectEditorialNotificationCapability(): Promise<EditorialNotificationCapability> {
  const secureContext = typeof window !== "undefined" && window.isSecureContext;
  const supported = secureContext && "Notification" in window;
  const base = { secureContext, supported, permission: supported ? Notification.permission : "unsupported" as const };
  if (typeof navigator === "undefined" || !secureContext || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    return { ...base, subscription: "unsupported" };
  }
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return { ...base, subscription: "no-service-worker" };
    return { ...base, subscription: (await registration.pushManager.getSubscription()) ? "subscribed" : "unsubscribed" };
  } catch {
    return { ...base, subscription: "unknown" };
  }
}

export function isEditorialNotificationTarget(path: string): boolean {
  return /^\/editorial\/reviews\/[a-zA-Z0-9_-]+$/.test(path);
}

export function openEditorialNotificationTarget(path: string): boolean {
  if (typeof window === "undefined" || !isEditorialNotificationTarget(path)) return false;
  window.location.assign(path);
  return true;
}
