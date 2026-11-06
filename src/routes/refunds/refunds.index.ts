import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./refunds.handlers";
import * as routes from "./refunds.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.requestRefund, handlers.requestRefund);
router.openapi(routes.listRefunds, handlers.listRefunds);
router.openapi(routes.approveRefund, handlers.approveRefund);
router.openapi(routes.rejectRefund, handlers.rejectRefund);
router.openapi(routes.withdrawRefund, handlers.withdrawRefund);
router.openapi(routes.payRefund, handlers.payRefund);
router.openapi(routes.reverseRefund, handlers.reverseRefund);

export default router;
