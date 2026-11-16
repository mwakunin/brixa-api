import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./stock-alerts.handlers";
import * as routes from "./stock-alerts.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.listAlerts, handlers.listAlerts);

export default router;
