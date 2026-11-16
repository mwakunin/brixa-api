import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./controlled-register.handlers";
import * as routes from "./controlled-register.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.viewRegister, handlers.viewRegister);

export default router;
