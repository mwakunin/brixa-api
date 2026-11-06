import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./invoices.handlers";
import * as routes from "./invoices.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.draftInvoice, handlers.draftInvoice);
router.openapi(routes.listInvoices, handlers.listInvoices);
router.openapi(routes.getInvoice, handlers.getInvoice);
router.openapi(routes.finaliseInvoice, handlers.finaliseInvoice);
router.openapi(routes.voidInvoice, handlers.voidInvoice);

export default router;
