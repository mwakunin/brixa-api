import { createRouter } from "@/lib/create-app";

import * as handlers from "./superadmin.handlers";
import * as routes from "./superadmin.routes";

const router = createRouter()
  .openapi(routes.createFacility, handlers.createFacility)
  .openapi(routes.listFacilities, handlers.listFacilities)
  .openapi(routes.setSmsSender, handlers.setSmsSender)
  .openapi(routes.exportSignInEvents, handlers.exportSignInEvents)
  .openapi(routes.resetTwoFactor, handlers.resetTwoFactor);

export default router;
