import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./documents.handlers";
import * as routes from "./documents.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.getDocumentPdf, handlers.getDocumentPdf);

export default router;
