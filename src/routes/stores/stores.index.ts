import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./stores.handlers";
import * as routes from "./stores.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.listStores, handlers.listStores);
router.openapi(routes.createStore, handlers.createStore);
router.openapi(routes.updateStore, handlers.updateStore);
router.openapi(routes.listReorderLevels, handlers.listReorderLevels);
router.openapi(routes.setReorderLevels, handlers.setReorderLevels);

export default router;
