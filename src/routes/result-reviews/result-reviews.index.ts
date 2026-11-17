import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./result-reviews.handlers";
import * as routes from "./result-reviews.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.listToReview, handlers.listToReview);
router.openapi(routes.markReviewed, handlers.markReviewed);

export default router;
