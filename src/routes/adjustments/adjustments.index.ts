import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./adjustments.handlers";
import * as routes from "./adjustments.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.requestAdjustment, handlers.requestAdjustment);
router.openapi(routes.listAdjustments, handlers.listAdjustments);
router.openapi(routes.approveAdjustment, handlers.approveAdjustment);
router.openapi(routes.rejectAdjustment, handlers.rejectAdjustment);
router.openapi(routes.withdrawAdjustment, handlers.withdrawAdjustment);
router.openapi(routes.requestReversal, handlers.requestReversal);
router.openapi(routes.listReversals, handlers.listReversals);
router.openapi(routes.approveReversal, handlers.approveReversal);
router.openapi(routes.rejectReversal, handlers.rejectReversal);
router.openapi(routes.withdrawReversal, handlers.withdrawReversal);

export default router;
