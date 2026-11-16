import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./stock-takes.handlers";
import * as routes from "./stock-takes.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.openTake, handlers.openTake);
router.openapi(routes.listTakes, handlers.listTakes);
router.openapi(routes.getTake, handlers.getTake);
router.openapi(routes.recordCounts, handlers.recordCounts);
router.openapi(routes.submitTake, handlers.submitTake);
router.openapi(routes.cancelTake, handlers.cancelTake);

export default router;
