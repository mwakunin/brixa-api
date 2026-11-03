import { createRouter } from "@/lib/create-app";

import * as handlers from "./me.handlers";
import * as routes from "./me.routes";

const router = createRouter()
  .openapi(routes.listMyFacilities, handlers.listMyFacilities);

export default router;
