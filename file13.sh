SAML_ENTRY_POINT=https://idp.example.com/saml/sso
SAML_ISSUER=https://idp.example.com
# Prefer the metadata URL when the IdP publishes one:
SAML_IDP_METADATA_URL=https://idp.example.com/saml/metadata
# Otherwise supply the signing certificate as a PEM-encoded string:
# SAML_IDP_CERT="-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
