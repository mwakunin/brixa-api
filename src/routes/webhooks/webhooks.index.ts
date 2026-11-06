import { createRouter } from "@/lib/create-app";

import * as handlers from "./webhooks.handlers";
import * as routes from "./webhooks.routes";

const router = createRouter()
  .openapi(routes.c2bConfirmation, handlers.c2bConfirmation)
  .openapi(routes.c2bValidation, handlers.c2bValidation)
  .openapi(routes.stkCallback, handlers.stkCallback);

export default router;
