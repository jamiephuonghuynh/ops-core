export type Task001DataType = "text" | "number" | "datetime";

export interface Task001FieldMapping {
  sourceField: string;
  standardField: string;
  dataType: Task001DataType;
  required: boolean;
}

export const TASK001_ID = "task001_smartlink_order";
export const TASK001_DEFINITION_VERSION = "TASK001-PRODUCTION-CUTOVER-01";

export const GAPP_INPUT_MAPPINGS: Task001FieldMapping[] = [
  { sourceField: "IDtracking", standardField: "order_id", dataType: "text", required: false },
  { sourceField: "Mobile Order", standardField: "user_account", dataType: "text", required: false },
  { sourceField: "RewardCode", standardField: "product_code", dataType: "text", required: false },
  { sourceField: "RewardName", standardField: "product_name", dataType: "text", required: false },
  { sourceField: "Quantity", standardField: "quantity", dataType: "number", required: false },
  { sourceField: "ReceiveName", standardField: "receiver_name", dataType: "text", required: false },
  { sourceField: "Mobile", standardField: "mobile", dataType: "text", required: false },
  { sourceField: "Province", standardField: "province", dataType: "text", required: false },
  { sourceField: "District", standardField: "district", dataType: "text", required: false },
  { sourceField: "Ward", standardField: "ward", dataType: "text", required: false },
  { sourceField: "Address", standardField: "address", dataType: "text", required: false },
  { sourceField: "PersonalIdNumber", standardField: "personal_id_number", dataType: "text", required: false },
  { sourceField: "Tax", standardField: "tax_number", dataType: "text", required: false },
  { sourceField: "Name Invoice", standardField: "invoice_name", dataType: "text", required: false },
  { sourceField: "Address Invoice", standardField: "invoice_address", dataType: "text", required: false },
  { sourceField: "Loại tại khoản", standardField: "gapp_account_type", dataType: "text", required: false },
  { sourceField: "Loại hình KD", standardField: "business_license_type", dataType: "text", required: false },
  { sourceField: "CreatedAt", standardField: "created_at", dataType: "datetime", required: false },
  { sourceField: "Stock", standardField: "gapp_warehouse", dataType: "text", required: false },
  { sourceField: "PointBeforeConvert", standardField: "point_before", dataType: "number", required: false },
  { sourceField: "Point", standardField: "point_charged", dataType: "number", required: false },
  { sourceField: "PointFinal", standardField: "point_after", dataType: "number", required: false },
  { sourceField: "Price", standardField: "price_gapp", dataType: "number", required: false },
  { sourceField: "Thuế", standardField: "tax_rate_gapp", dataType: "number", required: false },
  { sourceField: "Đề Xuất", standardField: "proposal_id", dataType: "text", required: false },
];

export const VENDOR_INPUT_MAPPINGS: Task001FieldMapping[] = [
  { sourceField: "VendorID", standardField: "vendor_id", dataType: "text", required: false },
  { sourceField: "StandardCode", standardField: "standard_code", dataType: "text", required: false },
  { sourceField: "StandardName", standardField: "standard_name", dataType: "text", required: false },
  { sourceField: "RetailPrice(+VAT)", standardField: "unit_price", dataType: "number", required: false },
];

export const SALES_AREA_INPUT_MAPPINGS: Task001FieldMapping[] = [
  { sourceField: "BU", standardField: "business_unit", dataType: "text", required: false },
  { sourceField: "Khu vực", standardField: "business_unit_location", dataType: "text", required: false },
  { sourceField: "Tỉnh thành", standardField: "province_standard", dataType: "text", required: false },
  { sourceField: "Phường xã", standardField: "ward_standard", dataType: "text", required: false },
  { sourceField: "Tỉnh thành cũ", standardField: "province_standard_old", dataType: "text", required: false },
];

export const GAPP_OUTPUT_MAPPINGS: Task001FieldMapping[] = [
  { sourceField: "Nhà cung cấp", standardField: "vendor_id", dataType: "text", required: false },
  { sourceField: "Ngày yêu cầu", standardField: "requested_at", dataType: "datetime", required: false },
  { sourceField: "Số hoá đơn", standardField: "invoice_number", dataType: "text", required: false },
  { sourceField: "Mã vận đơn", standardField: "delivery_code", dataType: "text", required: false },
  { sourceField: "RunID", standardField: "run_id", dataType: "text", required: false },
  { sourceField: "IDtracking", standardField: "order_id", dataType: "text", required: false },
  { sourceField: "Mobile Order", standardField: "user_account", dataType: "text", required: false },
  { sourceField: "RewardCode", standardField: "product_code", dataType: "text", required: false },
  { sourceField: "RewardName", standardField: "product_name", dataType: "text", required: false },
  { sourceField: "Quantity", standardField: "quantity", dataType: "number", required: false },
  { sourceField: "UnitPrice", standardField: "unit_price", dataType: "number", required: false },
  { sourceField: "Thành tiền", standardField: "amount", dataType: "number", required: false },
  { sourceField: "ReceiveName", standardField: "receiver_name", dataType: "text", required: false },
  { sourceField: "Mobile", standardField: "mobile", dataType: "text", required: false },
  { sourceField: "Province", standardField: "province", dataType: "text", required: false },
  { sourceField: "District", standardField: "district", dataType: "text", required: false },
  { sourceField: "Ward", standardField: "ward", dataType: "text", required: false },
  { sourceField: "Address", standardField: "address", dataType: "text", required: false },
  { sourceField: "PersonalIdNumber", standardField: "personal_id_number", dataType: "text", required: false },
  { sourceField: "Tax", standardField: "tax_number", dataType: "text", required: false },
  { sourceField: "Name Invoice", standardField: "invoice_name", dataType: "text", required: false },
  { sourceField: "Address Invoice", standardField: "invoice_address", dataType: "text", required: false },
  { sourceField: "Province Invoice", standardField: "province_invoice", dataType: "text", required: false },
  { sourceField: "Loại tại khoản", standardField: "gapp_account_type", dataType: "text", required: false },
  { sourceField: "Loại hình KD", standardField: "business_license_type", dataType: "text", required: false },
  { sourceField: "CreatedAt", standardField: "created_at", dataType: "datetime", required: false },
  { sourceField: "Stock", standardField: "gapp_warehouse", dataType: "text", required: false },
  { sourceField: "PointBeforeConvert", standardField: "point_before", dataType: "number", required: false },
  { sourceField: "Point", standardField: "point_charged", dataType: "number", required: false },
  { sourceField: "PointFinal", standardField: "point_after", dataType: "number", required: false },
  { sourceField: "Price", standardField: "price_gapp", dataType: "number", required: false },
  { sourceField: "Thuế", standardField: "tax_rate_gapp", dataType: "number", required: false },
  { sourceField: "Đề Xuất", standardField: "proposal_id", dataType: "text", required: false },
  { sourceField: "Vùng", standardField: "business_unit_location", dataType: "text", required: false },
];

export const VENDOR_OUTPUT_MAPPINGS: Task001FieldMapping[] = [
  { sourceField: "Nhà cung cấp", standardField: "vendor_id", dataType: "text", required: false },
  { sourceField: "ID", standardField: "order_id", dataType: "text", required: false },
  { sourceField: "Mã sản phẩm", standardField: "product_code", dataType: "text", required: false },
  { sourceField: "Tên sản phẩm", standardField: "product_name", dataType: "text", required: false },
  { sourceField: "Số lượng", standardField: "quantity", dataType: "number", required: false },
  { sourceField: "Tên người nhận hàng", standardField: "receiver_name", dataType: "text", required: false },
  { sourceField: "Số điện thoại", standardField: "mobile", dataType: "text", required: false },
  { sourceField: "Tỉnh / Thành", standardField: "province", dataType: "text", required: false },
  { sourceField: "Quận / Huyện", standardField: "district", dataType: "text", required: false },
  { sourceField: "Phường / Xã", standardField: "ward", dataType: "text", required: false },
  { sourceField: "Địa chỉ", standardField: "address", dataType: "text", required: false },
  { sourceField: "Ngày yêu cầu", standardField: "requested_at", dataType: "datetime", required: false },
];

export const TASK001_TEXT_IDENTIFIER_FIELDS = ["order_id", "user_account", "mobile", "personal_id_number", "tax_number"] as const;
export const TASK001_COMPARABLE_FIELDS = [
  "order_id", "product_code", "product_name", "quantity", "unit_price", "amount", "price_gapp",
  "receiver_name", "mobile", "province", "district", "ward", "address",
] as const;

export const GAPP_OUTPUT_FIELDS = GAPP_OUTPUT_MAPPINGS.map((mapping) => mapping.standardField);
export const VENDOR_OUTPUT_FIELDS = VENDOR_OUTPUT_MAPPINGS.map((mapping) => mapping.standardField);
export const GAPP_BUSINESS_HASH_FIELDS = GAPP_OUTPUT_FIELDS.filter((field) => field !== "requested_at");
export const VENDOR_BUSINESS_HASH_FIELDS = VENDOR_OUTPUT_FIELDS.filter((field) => field !== "requested_at");


export interface Task001MappingBundle {
  gappInput: Task001FieldMapping[];
  vendorInput: Task001FieldMapping[];
  salesAreaInput: Task001FieldMapping[];
  gappOutput: Task001FieldMapping[];
  deliveryOutput: Task001FieldMapping[];
}

export const DEFAULT_TASK001_MAPPING_BUNDLE: Task001MappingBundle = {
  gappInput: GAPP_INPUT_MAPPINGS,
  vendorInput: VENDOR_INPUT_MAPPINGS,
  salesAreaInput: SALES_AREA_INPUT_MAPPINGS,
  gappOutput: GAPP_OUTPUT_MAPPINGS,
  deliveryOutput: VENDOR_OUTPUT_MAPPINGS,
};
