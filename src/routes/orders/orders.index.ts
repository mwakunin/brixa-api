import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./orders.handlers";
import * as routes from "./orders.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.placeOrder, handlers.placeOrder);
router.openapi(routes.placeWalkInOrder, handlers.placeWalkInOrder);
router.openapi(routes.listOrders, handlers.listOrders);
router.openapi(routes.cancelOrderItem, handlers.cancelOrderItem);
router.openapi(routes.markServiceDone, handlers.markServiceDone);

export default router;
