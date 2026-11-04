import { createRouter } from "@/lib/create-app";

import * as handlers from "./verify.handlers";
import * as routes from "./verify.routes";

const router = createRouter()
  .openapi(routes.verifyDocument, handlers.verifyDocument);

export default router;
