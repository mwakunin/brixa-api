import { createRouter } from "@/lib/create-app";

import * as handlers from "./invitations.handlers";
import * as routes from "./invitations.routes";

const router = createRouter()
  .openapi(routes.acceptInvitation, handlers.acceptInvitation);

export default router;
