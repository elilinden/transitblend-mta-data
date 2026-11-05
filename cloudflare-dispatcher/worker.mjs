// Cloudflare's entry module exports only the supported handler.
import { createDispatcher } from './dispatcher.mjs';

const dispatch = createDispatcher();
export default {
  // Defense in depth if someone accidentally enables an HTTP route later.
  fetch() { return new Response('Not found', { status: 404 }); },
  async scheduled(controller, env) {
    const result = await dispatch(controller, env);
    if (!result.ok) throw new Error(`MTA dispatcher: ${result.outcome}`); // Fixed sanitized code only.
  },
};
