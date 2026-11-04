import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./payments.handlers";
import * as routes from "./payments.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.recordPayment, handlers.recordPayment);
router.openapi(routes.getPayment, handlers.getPayment);
router.openapi(routes.reversePayment, handlers.reversePayment);
router.openapi(routes.allocatePayment, handlers.allocatePayment);
router.openapi(routes.reverseAllocation, handlers.reverseAllocation);
router.openapi(routes.getAccount, handlers.getAccount);

export default router;
