import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./facility.handlers";
import * as routes from "./facility.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.getFacility, handlers.getFacility);

export default router;
