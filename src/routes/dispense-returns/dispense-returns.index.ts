import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./dispense-returns.handlers";
import * as routes from "./dispense-returns.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.recordReturn, handlers.recordReturn);
router.openapi(routes.listReturns, handlers.listReturns);
router.openapi(routes.approveReturn, handlers.approveReturn);
router.openapi(routes.rejectReturn, handlers.rejectReturn);

export default router;
