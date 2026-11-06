import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./prices.handlers";
import * as routes from "./prices.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.listItems, handlers.listItems);
router.openapi(routes.createItem, handlers.createItem);
router.openapi(routes.listChanges, handlers.listChanges);
router.openapi(routes.requestChange, handlers.requestChange);
router.openapi(routes.approveChange, handlers.approveChange);
router.openapi(routes.rejectChange, handlers.rejectChange);
router.openapi(routes.withdrawChange, handlers.withdrawChange);

export default router;
