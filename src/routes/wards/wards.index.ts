import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./wards.handlers";
import * as routes from "./wards.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.listWards, handlers.listWards);
router.openapi(routes.createWard, handlers.createWard);
router.openapi(routes.addBed, handlers.addBed);
router.openapi(routes.setBedDayItem, handlers.setBedDayItem);

export default router;
