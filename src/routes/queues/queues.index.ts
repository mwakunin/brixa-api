import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./queues.handlers";
import * as routes from "./queues.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.listServicePoints, handlers.listServicePoints);
router.openapi(routes.createServicePoint, handlers.createServicePoint);
router.openapi(routes.updateServicePoint, handlers.updateServicePoint);
router.openapi(routes.viewQueue, handlers.viewQueue);
router.openapi(routes.joinQueue, handlers.joinQueue);
router.openapi(routes.serve, handlers.serve);
router.openapi(routes.finish, handlers.finish);
router.openapi(routes.removeFromQueue, handlers.removeFromQueue);

export default router;
