# Genuine `orders/paid` payload — field extract

Redacted extract of the payload Shopify delivered on 2026-07-27 (task 45). The order
and customer were throwaway and are deleted. See
[genuine-orders-paid-webhook.md](./genuine-orders-paid-webhook.md) for the analysis.

### Money-bearing fields as delivered (verbatim values, synthetic order)

| field | value | type |
|---|---|---|
| `current_subtotal_price` | `"949.95"` | string |
| `current_total_additional_fees_set` | `null` | object |
| `current_total_discounts` | `"0.00"` | string |
| `current_total_duties_set` | `null` | object |
| `current_total_price` | `"949.95"` | string |
| `current_total_tax` | `"0.00"` | string |
| `estimated_taxes` | `false` | boolean |
| `original_total_additional_fees_set` | `null` | object |
| `original_total_duties_set` | `null` | object |
| `subtotal_price` | `"949.95"` | string |
| `tax_exempt` | `false` | boolean |
| `taxes_included` | `false` | boolean |
| `total_discounts` | `"0.00"` | string |
| `total_line_items_price` | `"949.95"` | string |
| `total_outstanding` | `"0.00"` | string |
| `total_price` | `"949.95"` | string |
| `total_tax` | `"0.00"` | string |
| `total_tip_received` | `"0.00"` | string |
| `total_weight` | `0` | number |

Money fields delivered as nested `*_set` objects (shop + presentment money), all ignored by the service:

`current_shipping_price_set`, `current_subtotal_price_set`, `current_total_discounts_set`, `current_total_price_set`, `current_total_tax_set`, `discount_applications`, `discount_codes`, `subtotal_price_set`, `tax_lines`, `total_cash_rounding_payment_adjustment_set`, `total_cash_rounding_refund_adjustment_set`, `total_discounts_set`, `total_line_items_price_set`, `total_price_set`, `total_shipping_price_set`, `total_tax_set`

### Identity + control fields

| field | value | type |
|---|---|---|
| `id` | `7095742234823` | number |
| `financial_status` | `"paid"` | string |
| `currency` | `"USD"` | string |
| `presentment_currency` | `"USD"` | string |
| `test` | `false` | boolean |
| `confirmed` | `true` | boolean |
| `source_name` | `"402279628801"` | string |
| `customer.id` | `9038603256007` | number |

### All 94 top-level keys delivered

`admin_graphql_api_id`, `app_id`, ~~`billing_address`~~, ~~`browser_ip`~~, `buyer_accepts_marketing`, `cancel_reason`, `cancelled_at`, ~~`cart_token`~~, ~~`checkout_token`~~, ~~`client_details`~~, `closed_at`, `company`, `confirmation_number`, `confirmed`, ~~`contact_email`~~, `created_at`, `currency`, `current_shipping_price_set`, `current_subtotal_price`, `current_subtotal_price_set`, `current_total_additional_fees_set`, `current_total_discounts`, `current_total_discounts_set`, `current_total_duties_set`, `current_total_price`, `current_total_price_set`, `current_total_tax`, `current_total_tax_set`, ~~`customer`~~, `customer_locale`, `device_id`, `discount_applications`, `discount_codes`, `duties_included`, ~~`email`~~, `estimated_taxes`, `financial_status`, `fulfillment_status`, `fulfillments`, `id`, `landing_site`, `landing_site_ref`, `line_item_groups`, `line_items`, `location_id`, `merchant_business_entity_id`, `merchant_of_record_app_id`, `name`, `note`, `note_attributes`, `number`, `order_number`, ~~`order_status_url`~~, `original_total_additional_fees_set`, `original_total_duties_set`, `payment_gateway_names`, `payment_terms`, ~~`phone`~~, `po_number`, `presentment_currency`, `processed_at`, `reference`, `referring_site`, `refunds`, `returns`, ~~`shipping_address`~~, `shipping_lines`, `source_identifier`, `source_name`, `source_url`, `subtotal_price`, `subtotal_price_set`, `tags`, `tax_exempt`, `tax_lines`, `taxes_included`, `test`, ~~`token`~~, `total_cash_rounding_payment_adjustment_set`, `total_cash_rounding_refund_adjustment_set`, `total_discounts`, `total_discounts_set`, `total_line_items_price`, `total_line_items_price_set`, `total_outstanding`, `total_price`, `total_price_set`, `total_shipping_price_set`, `total_tax`, `total_tax_set`, `total_tip_received`, `total_weight`, `updated_at`, `user_id`

Struck-through keys were present but are redacted here (session tokens, urls, ip, PII).
