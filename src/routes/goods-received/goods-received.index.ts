import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./goods-received.handlers";
import * as routes from "./goods-received.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.receiveGoods, handlers.receiveGoods);
router.openapi(routes.listNotes, handlers.listNotes);
router.openapi(routes.getNote, handlers.getNote);
router.openapi(routes.reverseBatch, handlers.reverseBatch);

export default router;
