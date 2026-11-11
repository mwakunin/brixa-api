import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./lab.handlers";
import * as routes from "./lab.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.viewWorklist, handlers.viewWorklist);
router.openapi(routes.collectSpecimen, handlers.collectSpecimen);
router.openapi(routes.receiveSpecimen, handlers.receiveSpecimen);
router.openapi(routes.rejectSpecimen, handlers.rejectSpecimen);
router.openapi(routes.recollectSpecimen, handlers.recollectSpecimen);

export default router;
