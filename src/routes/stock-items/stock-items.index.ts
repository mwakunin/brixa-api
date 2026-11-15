import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./stock-items.handlers";
import * as routes from "./stock-items.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.listStockItems, handlers.listStockItems);
router.openapi(routes.createStockItem, handlers.createStockItem);
router.openapi(routes.updateStockItem, handlers.updateStockItem);

export default router;
