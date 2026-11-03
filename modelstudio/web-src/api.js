// Thin wrapper over the ModelStudio HTTP API. The editor never talks to the
// engine directly: every edit is a command, so manual and AI changes are the
// same records on disk.

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { ok: false, error: { code: 'bad_response', message: text.slice(0, 300) } };
  }
  if (!response.ok && payload && !payload.error) {
    payload.error = { code: `http_${response.status}`, message: text.slice(0, 300) };
  }
  return payload;
}

export const api = {
  health: () => request('/api/health'),
  capabilities: () => request('/api/capabilities'),
  projects: () => request('/api/projects'),
  createProject: (name) => request('/api/projects', { method: 'POST', body: JSON.stringify({ name }) }),
  deleteProject: (ref) => request(`/api/projects/${encodeURIComponent(ref)}`, { method: 'DELETE' }),
  state: (ref, since = -1) => request(`/api/projects/${encodeURIComponent(ref)}/state?since=${since}`),

  async command(ref, command, input = {}) {
    const result = await request(`/api/projects/${encodeURIComponent(ref)}/commands/${command}`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    if (result && result.ok === false) {
      throw Object.assign(new Error(result.error?.message ?? 'command failed'), { code: result.error?.code, payload: result });
    }
    return result;
  },

  async uploadTexture(ref, { name, dataUrl }) {
    return api.command(ref, 'texture.upload', { name, data: dataUrl });
  },

  textureUrl: (ref, id) => `/api/projects/${encodeURIComponent(ref)}/textures/${id}?t=${Date.now()}`,
  previewUrl: (ref, params = {}) => {
    const query = new URLSearchParams({ t: Date.now(), ...params });
    return `/api/projects/${encodeURIComponent(ref)}/preview?${query}`;
  },

  events: () => new EventSource('/api/events'),
};
