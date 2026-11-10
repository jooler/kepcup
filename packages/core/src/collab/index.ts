export { PresenceService, type PresenceServiceDeps } from './presence.js';
export {
  DraftService,
  type DraftServiceDeps,
  type DraftServiceEvents,
  type DraftSendInput,
} from './drafts.js';
export { withClientIdentityBinding, type ClientIdentityBinding } from './identity-binding.js';
export { sanitizeClientName } from './client-name.js';
