import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./break-glass.handlers";
import * as routes from "./break-glass.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.breakGlass, handlers.breakGlass);
router.openapi(routes.listBreakGlass, handlers.listBreakGlass);
router.openapi(routes.reviewBreakGlass, handlers.reviewBreakGlass);

export default router;
