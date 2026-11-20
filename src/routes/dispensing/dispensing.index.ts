import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./dispensing.handlers";
import * as routes from "./dispensing.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.worklist, handlers.worklist);
router.openapi(routes.getDispense, handlers.getDispense);
router.openapi(routes.prepare, handlers.prepare);
router.openapi(routes.quote, handlers.quote);
router.openapi(routes.handOver, handlers.handOver);
router.openapi(routes.cancel, handlers.cancel);
router.openapi(routes.notSupplied, handlers.notSupplied);

export default router;
