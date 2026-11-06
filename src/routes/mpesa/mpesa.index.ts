import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./mpesa.handlers";
import * as routes from "./mpesa.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.getSettings, handlers.getSettings);
router.openapi(routes.putSettings, handlers.putSettings);
router.openapi(routes.listTransactions, handlers.listTransactions);
router.openapi(routes.assignTransaction, handlers.assignTransaction);
router.openapi(routes.rejectTransaction, handlers.rejectTransaction);
router.openapi(routes.requestStk, handlers.requestStk);
router.openapi(routes.getStk, handlers.getStk);

export default router;
