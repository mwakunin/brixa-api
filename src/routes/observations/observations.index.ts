import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./observations.handlers";
import * as routes from "./observations.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.recordVitals, handlers.recordVitals);
router.openapi(routes.listObservations, handlers.listObservations);
router.openapi(routes.markEnteredInError, handlers.markEnteredInError);

export default router;
