import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./stock-transfers.handlers";
import * as routes from "./stock-transfers.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.listTransfers, handlers.listTransfers);
router.openapi(routes.getTransfer, handlers.getTransfer);
router.openapi(routes.requestTransfer, handlers.requestTransfer);
router.openapi(routes.sendDirect, handlers.sendDirect);
router.openapi(routes.sendTransfer, handlers.sendTransfer);
router.openapi(routes.receiveTransfer, handlers.receiveTransfer);
router.openapi(routes.acceptShortfall, handlers.acceptShortfall);
router.openapi(routes.cancelTransfer, handlers.cancelTransfer);
router.openapi(routes.declineTransfer, handlers.declineTransfer);

export default router;
