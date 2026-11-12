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
router.openapi(routes.enterResult, handlers.enterResult);
router.openapi(routes.releaseResult, handlers.releaseResult);
router.openapi(routes.verifyResult, handlers.verifyResult);
router.openapi(routes.listResults, handlers.listResults);

export default router;
