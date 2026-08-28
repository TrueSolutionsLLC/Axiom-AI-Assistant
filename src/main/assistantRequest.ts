import type { AssistantRequest } from '../shared/contracts';

/** Keep renderer-supplied perception evidence intact while normalizing user text. */
export function forwardAssistantRequest(input:AssistantRequest,cleanMessage:string):AssistantRequest {
  return {
    message:cleanMessage,
    history:input.history,
    imageDataUrl:input.imageDataUrl,
    identity:input.identity,
    untrustedPresence:input.untrustedPresence,
  };
}
