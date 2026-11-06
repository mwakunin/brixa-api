import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./charges.handlers";
import * as routes from "./charges.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.postCharge, handlers.postCharge);
router.openapi(routes.listCharges, handlers.listCharges);
router.openapi(routes.cancelCharge, handlers.cancelCharge);

export default router;
