import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./shifts.handlers";
import * as routes from "./shifts.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.openShift, handlers.openShift);
// Before `/{id}`, so "current" is not read as an id.
router.openapi(routes.currentShift, handlers.currentShift);
router.openapi(routes.listShifts, handlers.listShifts);
router.openapi(routes.getShift, handlers.getShift);
router.openapi(routes.closeShift, handlers.closeShift);

export default router;
