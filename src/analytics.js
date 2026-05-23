const ANALYTICS_URL = "https://us.i.posthog.com/capture/";
const ANALYTICS_KEY = "phc_w2Me8DP7jK9YHmxWns6XkPx2gpNBVinxcBYx5Mqkq8ap";

function getDistinctId() {
  const key = "install_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

window.track = async function(event, properties = {}) {
  try {
    const body = {
      api_key: ANALYTICS_KEY,
      event,
      distinct_id: getDistinctId(),
      properties: {
        ...properties,
      },
    };

    await fetch(ANALYTICS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    });
  } catch (_) {}
}