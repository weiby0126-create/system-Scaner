type NetworkPayload = {
  type: "CDA_NETWORK_CAPTURE";
  payload: {
    url: string;
    method: string;
    status: number | "";
    type: "fetch" | "xhr";
  };
};

function emit(payload: NetworkPayload["payload"]) {
  window.postMessage({ type: "CDA_NETWORK_CAPTURE", payload } satisfies NetworkPayload, "*");
}

const originalFetch = window.fetch;
window.fetch = async (...args) => {
  const input = args[0];
  const init = args[1];
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");

  try {
    const response = await originalFetch(...args);
    emit({ url, method, status: response.status, type: "fetch" });
    return response;
  } catch (error) {
    emit({ url, method, status: "", type: "fetch" });
    throw error;
  }
};

const originalOpen = XMLHttpRequest.prototype.open;
const originalSend = XMLHttpRequest.prototype.send;
const xhrMeta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();

XMLHttpRequest.prototype.open = function patchedOpen(method: string, url: string | URL) {
  xhrMeta.set(this, { method, url: url.toString() });
  return Reflect.apply(originalOpen, this, Array.from(arguments));
};

XMLHttpRequest.prototype.send = function patchedSend() {
  const xhr = this;
  const record = () => {
    const meta = xhrMeta.get(xhr);
    if (!meta?.url) return;
    emit({
      url: meta.url,
      method: meta.method || "GET",
      status: xhr.status || "",
      type: "xhr"
    });
  };

  xhr.addEventListener("loadend", record, { once: true });
  return Reflect.apply(originalSend, this, Array.from(arguments));
};

const originalPushState = history.pushState;
const originalReplaceState = history.replaceState;

function notifyLocationChange() {
  window.dispatchEvent(new Event("cda-location-change"));
}

history.pushState = function patchedPushState() {
  const result = Reflect.apply(originalPushState, this, Array.from(arguments));
  notifyLocationChange();
  return result;
};

history.replaceState = function patchedReplaceState() {
  const result = Reflect.apply(originalReplaceState, this, Array.from(arguments));
  notifyLocationChange();
  return result;
};

window.addEventListener("popstate", notifyLocationChange);
