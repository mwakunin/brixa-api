import { createRouter } from "@/lib/create-app";

import * as handlers from "./superadmin.handlers";
import * as routes from "./superadmin.routes";

const router = createRouter()
  .openapi(routes.createFacility, handlers.createFacility)
  .openapi(routes.listFacilities, handlers.listFacilities)
  .openapi(routes.setSmsSender, handlers.setSmsSender);

export default router;
