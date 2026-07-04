/** Trimmed-down but structurally faithful BC v2.0 $metadata document. */
export const SAMPLE_EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Microsoft.NAV" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="company">
        <Key>
          <PropertyRef Name="id" />
        </Key>
        <Property Name="id" Type="Edm.Guid" Nullable="false" />
        <Property Name="name" Type="Edm.String" MaxLength="30" />
        <Property Name="displayName" Type="Edm.String" MaxLength="250" />
      </EntityType>
      <EntityType Name="customer">
        <Key>
          <PropertyRef Name="id" />
        </Key>
        <Property Name="id" Type="Edm.Guid" Nullable="false" />
        <Property Name="number" Type="Edm.String" MaxLength="20" />
        <Property Name="displayName" Type="Edm.String" MaxLength="100" />
        <Property Name="blocked" Type="Edm.String" />
        <NavigationProperty Name="currency" Type="Microsoft.NAV.currency" />
      </EntityType>
      <EntityType Name="salesOrder">
        <Key>
          <PropertyRef Name="id" />
        </Key>
        <Property Name="id" Type="Edm.Guid" Nullable="false" />
        <Property Name="number" Type="Edm.String" MaxLength="20" />
        <Property Name="status" Type="Edm.String" />
      </EntityType>
      <EntityType Name="currency">
        <Key>
          <PropertyRef Name="id" />
        </Key>
        <Property Name="id" Type="Edm.Guid" Nullable="false" />
        <Property Name="code" Type="Edm.String" MaxLength="10" />
      </EntityType>
      <Action Name="shipAndInvoice" IsBound="true">
        <Parameter Name="bindingParameter" Type="Microsoft.NAV.salesOrder" />
      </Action>
      <Action Name="Microsoft.NAV.Release" IsBound="true">
        <Parameter Name="bindingParameter" Type="Microsoft.NAV.salesOrder" />
      </Action>
      <EntityContainer Name="NAV">
        <EntitySet Name="companies" EntityType="Microsoft.NAV.company" />
        <EntitySet Name="customers" EntityType="Microsoft.NAV.customer" />
        <EntitySet Name="salesOrders" EntityType="Microsoft.NAV.salesOrder" />
        <EntitySet Name="currencies" EntityType="Microsoft.NAV.currency" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
