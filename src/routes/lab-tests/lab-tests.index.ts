import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./lab-tests.handlers";
import * as routes from "./lab-tests.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.listLabTests, handlers.listLabTests);
router.openapi(routes.createLabTest, handlers.createLabTest);
router.openapi(routes.updateLabTest, handlers.updateLabTest);
router.openapi(routes.addAnalyte, handlers.addAnalyte);
router.openapi(routes.updateAnalyte, handlers.updateAnalyte);
router.openapi(routes.setReferenceRanges, handlers.setReferenceRanges);

export default router;
